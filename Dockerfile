FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --global npm@11.17.0 \
  && test "$(node --version)" = 'v24.19.0' \
  && test "$(npm --version)" = '11.17.0'
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --global npm@11.17.0 \
  && test "$(node --version)" = 'v24.19.0' \
  && test "$(npm --version)" = '11.17.0'
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3012
CMD ["node", "dist/main.js"]
