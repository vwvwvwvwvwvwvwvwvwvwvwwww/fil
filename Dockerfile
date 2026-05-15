# Сборка для Railway и других контейнерных хостингов (linux/amd64).
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY static ./static

# База SQLite, логи и загрузки должны быть доступны на запись.
RUN mkdir -p data logs static/uploads

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 8000

CMD ["node", "src/index.js"]
