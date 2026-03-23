FROM oven/bun:alpine AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
EXPOSE 7392
CMD ["bun", "run", "src/index.ts"]
