FROM node:24.18.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --global npm@11.16.0 \
  && test "$(node --version)" = 'v24.18.1' \
  && test "$(npm --version)" = '11.16.0'
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.18.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --global npm@11.16.0 \
  && test "$(node --version)" = 'v24.18.1' \
  && test "$(npm --version)" = '11.16.0'
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3012
CMD ["node", "dist/main.js"]
