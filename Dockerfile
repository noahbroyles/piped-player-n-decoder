FROM node:22-alpine

WORKDIR /app

# Dependencies first, so code changes don't reinstall them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The player script comes from YouTube, so run it as an unprivileged user
USER node

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=1m --timeout=5s CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1

CMD ["node", "src/server.mjs"]
