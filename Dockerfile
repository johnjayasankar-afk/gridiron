# Gridiron's persistent server: the built client, the bundled Node server and the
# replay fixtures, on a slim Node image. The bundle has no runtime dependencies.
#
#   docker build -t gridiron .
#   docker run -p 8787:8787 -v gridiron-cache:/app/.cache gridiron
#
# The cache volume keeps discovered college divisions, the generated VAPID keys and
# push subscriptions across restarts. Configure with environment variables (see .env.example).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/fixtures ./fixtures
RUN mkdir -p .cache && chown -R node:node /app
USER node
EXPOSE 8787
VOLUME ["/app/.cache"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist-server/index.mjs"]
