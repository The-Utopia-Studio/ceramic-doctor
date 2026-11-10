FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx playwright install --with-deps chromium && chmod -R a+rX /opt/playwright
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8787 CERAMIC_DOCTOR_DATABASE=/data/reviews.sqlite
EXPOSE 8787
CMD ["node", "src/github-app/server.mjs"]
