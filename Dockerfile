# Install the dependencies with npm, which the runtime image doesn't have
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Distroless: just Node and its libraries, no shell or package manager, so there is little to attack
# or patch. The nonroot tag runs as an unprivileged user, which matters because the player script
# comes from YouTube.
FROM gcr.io/distroless/nodejs22-debian13:nonroot

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3001

# No shell or wget here, so Node does the health check itself
HEALTHCHECK --interval=1m --timeout=5s CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# The image's entrypoint is node, so this is just the script
CMD ["src/server.mjs"]
