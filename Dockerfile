FROM oven/bun:1.4

WORKDIR /app

# Dependencias primero para aprovechar la caché de capas. Bun ejecuta TypeScript directo: no hay paso de build.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY modulo ./modulo
COPY demo.ts ./
# La app escribe en /app/out (maestro, historial, log) y el reinicio de la demo lo borra: el usuario bun debe poder hacerlo.
RUN chown -R bun:bun /app

ENV PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "src/server.ts"]
