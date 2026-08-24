FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG VERSION=dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/april-jk/dsh-relay" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/data/relay.sqlite
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
RUN mkdir -p /data && chown node:node /data
EXPOSE 8787
CMD ["sh", "-c", "chown -R node:node /data && exec setpriv --reuid=node --regid=node --init-groups npm start"]
