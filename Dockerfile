FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY integrations ./integrations
COPY web ./web
COPY ontology ./ontology
COPY skills ./skills
RUN npm run build && test -f dist/server/index.js && test -f dist/server/job.js && test -f dist/server/mcp-stdio.js

FROM node:24-alpine AS runtime
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
# Keep root data too: backend loaders may resolve JSON from the working directory.
COPY --from=build --chown=node:node /app/ontology ./ontology
COPY --from=build --chown=node:node /app/skills ./skills
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
