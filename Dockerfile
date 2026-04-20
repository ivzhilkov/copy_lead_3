FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json yarn.lock ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main"]
