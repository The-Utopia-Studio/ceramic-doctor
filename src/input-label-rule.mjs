// Analyze labels within the same JSX tree; identical IDs in another component
// must never satisfy a control's naming contract.
export const inputLabelRule = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const elements = []
    const attr = (node, name) => node.openingElement.attributes.find(a => a.type === 'JSXAttribute' && a.name.name === name)
    const value = a => a?.value?.type === 'Literal' ? (a.value.value == null || typeof a.value.value === 'boolean' ? '' : String(a.value.value)) : a?.value?.type === 'JSXExpressionContainer' && a.value.expression.type === 'Literal' ? (a.value.expression.value == null || typeof a.value.expression.value === 'boolean' ? '' : String(a.value.expression.value)) : null
    const meaningful = a => a && (value(a) !== null ? value(a).trim().length > 0 : a.value?.type === 'JSXExpressionContainer' && a.value.expression.type !== 'JSXEmptyExpression')
    const key = a => value(a) !== null ? `literal:${value(a)}` : a?.value?.type === 'JSXExpressionContainer' ? `expression:${context.sourceCode.getText(a.value.expression)}` : null
    const root = node => { let current = node; while (current.parent && ['JSXElement','JSXFragment','JSXExpressionContainer','ConditionalExpression','LogicalExpression','ArrayExpression'].includes(current.parent.type)) current = current.parent; return current }
    const hasText = node => node.children.some(c => c.type === 'JSXText' ? !!c.value.trim() : c.type === 'JSXExpressionContainer' ? c.expression.type === 'Literal' ? c.expression.value != null && typeof c.expression.value !== 'boolean' && String(c.expression.value).trim().length > 0 : c.expression.type !== 'JSXEmptyExpression' : c.type === 'JSXElement' && (meaningful(attr(c,'aria-label')) || hasText(c)))
    return {
      JSXElement(node) { elements.push(node) },
      'Program:exit'() {
        for (const node of elements) {
          const name = node.openingElement.name.name
          if (!['input','select','textarea', ...(context.settings.ceramicControls ?? [])].includes(name)) continue
          if (name === 'input' && ['hidden','submit','reset','button','image'].includes(value(attr(node,'type')))) continue
          if (meaningful(attr(node,'aria-label')) || meaningful(attr(node,'title'))) continue
          const peers = elements.filter(other => root(other) === root(node))
          const labelledBy = attr(node,'aria-labelledby'), ids = value(labelledBy)?.trim().split(/\s+/)
          if (ids?.length && ids.every(id => peers.some(other => value(attr(other,'id')) === id && hasText(other)))) continue
          // Dynamic references are resolved by the required rendered check.
          if (labelledBy && value(labelledBy) === null && meaningful(labelledBy)) continue
          const id = key(attr(node,'id'))
          if (id && peers.some(other => other.openingElement.name.name === 'label' && key(attr(other,'htmlFor')) === id && hasText(other))) continue
          let parent = node.parent, nested = false
          while (parent && parent !== root(node).parent) { if (parent.type === 'JSXElement' && parent.openingElement.name.name === 'label' && hasText(parent)) nested = true; parent = parent.parent }
          if (nested) continue
          context.report({ node: node.openingElement, message: 'Form control has no programmatic label in this JSX tree. Associate visible label text or a meaningful aria-label/aria-labelledby; placeholder is not a label.' })
        }
      },
    }
  },
}
