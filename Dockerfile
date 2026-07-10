# Portable image — works on Koyeb, Render, Oracle, any Docker host.
FROM node:20-slim

WORKDIR /app

# Install prod deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

# The app reads PORT from the environment (hosts inject it); 3000 is the local default.
EXPOSE 3000

CMD ["node", "server.js"]
