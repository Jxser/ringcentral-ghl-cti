FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
COPY server.js ./server.js
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN mkdir -p /data \
  && chown -R node:node /data /app \
  && chmod +x ./docker-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
