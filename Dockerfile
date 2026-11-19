FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3010 HOST=0.0.0.0
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY auth ./auth
COPY site ./site
VOLUME /data
USER node
EXPOSE 3010
CMD ["node", "server.js"]
