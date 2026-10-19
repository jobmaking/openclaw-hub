FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js manage-users.js VERSION ./
COPY lib ./lib
COPY public ./public
ENV PORT=18900 BIND=127.0.0.1 DATA_DIR=/data AGENTS_FILE=/data/agents.json MAX_UPLOAD_MB=25
EXPOSE 18900
CMD ["node", "server.js"]
