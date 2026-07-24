FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/recordings \
    && chown -R node:node /app

USER node

EXPOSE 9092

CMD ["node", "src/index.js"]

