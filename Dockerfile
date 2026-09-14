FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /app /data
USER node
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/astra-v2.db
EXPOSE 8080
CMD ["node", "src/server.js"]
