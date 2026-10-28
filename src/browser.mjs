import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { finding } from './contracts.mjs'

// Adapted from Ceramic's tools/ai-user-testing/runner.ts observe() and browser QA:
// use rendered geometry, fresh sessions, real focus movement and recorded evidence.
export async function observePage(page) {
  return page.evaluate(() => {
    const shown = element => {
      const rect = element.getBoundingClientRect(), css = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && css.visibility !== 'hidden' && css.display !== 'none'
    }
    return {
      title: document.title,
      language: document.documentElement.lang,
      direction: getComputedStyle(document.documentElement).direction,
      theme: document.documentElement.dataset.theme || document.body.dataset.theme || null,
      colorMode: document.documentElement.dataset.colorMode || document.body.dataset.colorMode || null,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      text: document.body.innerText.slice(0, 12000),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      brokenImages: [...document.images].filter(img => shown(img) && img.complete && img.naturalWidth === 0).map(img => img.id ? `#${CSS.escape(img.id)}` : `img[src="${CSS.escape(img.getAttribute('src') || '')}"]`).slice(0, 20),
      controls: [...document.querySelectorAll('button,select,input,a[href],[tabindex="0"]')].filter(shown).slice(0, 60).map(element => ({
        tag: element.tagName, label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 160) || '',
        disabled: element.matches(':disabled'), tabIndex: element.tabIndex,
      })),
    }
  })
}

async function perform(page, action) {
  const target = action.selector ? page.locator(action.selector) : null
  switch (action.kind) {
    case 'click': return target.click()
    case 'press': return page.keyboard.press(action.value === 'Space' ? ' ' : action.value)
    case 'fill': return target.fill(action.value)
    case 'select': return target.selectOption(action.value)
    case 'expectVisible': return target.waitFor({ state: 'visible' })
    case 'expectText': {
      await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent?.includes(value), action)
      return
    }
  }
}

export async function launchBrowser() {
  return chromium.launch({ headless: true })
}

export async function inspectScenario(browser, input, scenario, viewport, directory) {
  const { id: viewportId, width, height, ...device } = viewport
  const context = await browser.newContext({ ...device, viewport: { width: viewport.width, height: viewport.height },
    locale: scenario.locale ?? 'en-US', reducedMotion: scenario.reducedMotion ?? 'reduce', serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(input.timeoutMs)
  const runtimeErrors = [], failedRequests = []
  page.on('pageerror', error => { if (runtimeErrors.length < 20) runtimeErrors.push(error.message.slice(0, 1000)) })
  page.on('requestfailed', request => { if (failedRequests.length < 30) { const url = new URL(request.url()); failedRequests.push({ url: url.origin + url.pathname, reason: request.failure()?.errorText }) } })
  const coverage = { scenario: scenario.id, viewport: viewportId, width: viewport.width, height: viewport.height, status: 'blocked', checks: [], actionsCompleted: 0 }
  const evidence = { viewport: viewportId, scenario: scenario.id, screenshot: `${scenario.id}-${viewportId}.png` }
  const findings = []
  try {
    const response = await page.goto(scenario.url ?? input.url, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs })
    await page.locator(scenario.readySelector ?? input.readySelector ?? 'body').waitFor({ state: 'visible' })
    await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]))
    if (scenario.direction) await page.evaluate(direction => { document.documentElement.dir = direction }, scenario.direction)
    for (const action of scenario.actions) {
      await perform(page, action)
      coverage.actionsCompleted++
    }
    // Assertion steps/readiness are the readiness contract; no fixed sleep or network-idle assumption.
    const observation = await observePage(page)
    coverage.actual = { url: page.url(), language: observation.language, direction: observation.direction, theme: observation.theme, colorMode: observation.colorMode, reducedMotion: observation.reducedMotion }
    coverage.directionForced = Boolean(scenario.direction)
    await page.screenshot({ path: `${directory}/${evidence.screenshot}`, animations: 'disabled', timeout: input.timeoutMs })
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    coverage.checks.push(...new Set([...axe.passes, ...axe.violations, ...axe.inapplicable].map(rule => rule.id).filter(id => !axe.incomplete.some(rule => rule.id === id))))
    coverage.incomplete = axe.incomplete.map(rule => ({ rule: rule.id, nodes: rule.nodes.length }))
    for (const violation of axe.violations) {
      for (const node of violation.nodes.slice(0, 50)) {
        findings.push(finding({ rule: violation.id, category: 'accessibility', severity: violation.impact ?? 'moderate', title: violation.help,
          scenario: scenario.id, selector: node.target.join(' '),
          evidence: { ...evidence, engine: 'axe-core', helpUrl: violation.helpUrl, detail: node.failureSummary?.slice(0, 2000) },
          fix: `Fix ${violation.id} in the owning component or semantic token. ${violation.description} See ${violation.helpUrl}` }))
      }
    }
    coverage.checks.push('document-overflow', 'broken-image', 'runtime-error', 'http-status')
    if (observation.documentWidth > observation.viewportWidth + 1) findings.push(finding({ rule: 'document-overflow', category: 'responsive', severity: 'serious', title: 'Document overflows horizontally', selector: 'html', scenario: scenario.id,
      evidence: { ...evidence, detail: `${observation.documentWidth}px content in ${observation.viewportWidth}px viewport.` }, fix: 'Fix the owning layout contract. Contain wide tables/media in their intended scroll surface; preserve access to all content.' }))
    for (const selector of observation.brokenImages) findings.push(finding({ rule: 'broken-image', category: 'content', severity: 'moderate', title: 'Visible image failed to load', selector, scenario: scenario.id,
      evidence, fix: 'Repair the image source or its delivery configuration; preserve its accessible text alternative.' }))
    if (runtimeErrors.length) findings.push(finding({ rule: 'runtime-error', category: 'runtime', severity: 'serious', title: 'Uncaught browser error', scenario: scenario.id,
      evidence: { ...evidence, detail: runtimeErrors.join('\n') }, fix: 'Resolve the uncaught error in the component or data binding; re-run the same scenario.' }))
    if (response && response.status() >= 400) findings.push(finding({ rule: 'http-status', category: 'runtime', severity: 'serious', title: `Page returned HTTP ${response.status()}`, scenario: scenario.id,
      evidence, fix: 'Repair the route or server response and verify the intended page loads.' }))
    const keyboard = []
    // Tab samples are observations, not proof of complete keyboard/focus accessibility.
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press('Tab')
      keyboard.push(await page.evaluate(() => {
        const element = document.activeElement, rect = element?.getBoundingClientRect()
        return { tag: element?.tagName, label: (element?.getAttribute('aria-label') || element?.textContent || '').trim().slice(0, 100),
          inViewport: Boolean(rect && rect.width && rect.height && rect.top >= 0 && rect.bottom <= innerHeight) }
      }))
    }
    coverage.status = 'completed'
    return { coverage, findings, observation, keyboard, failedRequests, screenshot: evidence.screenshot }
  } catch (error) {
    coverage.message = String(error.message).slice(0, 1500)
    await page.screenshot({ path: `${directory}/${evidence.screenshot}`, animations: 'disabled', timeout: 3000 }).catch(() => {})
    return { coverage, findings, failedRequests, screenshot: evidence.screenshot }
  } finally { await context.close() }
}
