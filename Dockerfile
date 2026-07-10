# Portable production image — runs on AWS App Runner, ECS/Fargate, EB, or any Docker host.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install prod deps first (better layer caching). npm ci uses the lockfile for
# reproducible, deterministic installs.
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Drop root — run as the unprivileged "node" user baked into the base image.
RUN chown -R node:node /app
USER node

# The app reads PORT from the environment (hosts inject it); 3000 is the default.
EXPOSE 3000

# Container-level health check hits the public /health route (no curl dependency).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
