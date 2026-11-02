# Builds two images: --target controller and --target bot
FROM docker.io/library/node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

# Test media is generated at build time, so the repo holds no large files.
FROM docker.io/library/alpine:3.22 AS media
RUN apk add --no-cache ffmpeg && mkdir /testmedia \
 && ffmpeg -loglevel error -f lavfi -i testsrc2=size=640x360:rate=15:duration=6 -pix_fmt yuv420p /testmedia/video.y4m \
 && ffmpeg -loglevel error -f lavfi -i "aevalsrc='0.25*sin(2*PI*220*t)*sin(2*PI*3*t)*between(mod(t,10),0,6)':s=48000:d=30" -ac 1 -c:a pcm_s16le /testmedia/speech.wav

FROM docker.io/library/node:24-alpine AS controller
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/node_modules ./node_modules
COPY package.json ./
COPY scenarios ./scenarios
USER 1001:1001
ENV NODE_ENV=production
CMD ["node", "dist/controller/main.js"]

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS bot
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/node_modules ./node_modules
COPY --from=media /testmedia ./media
COPY package.json ./
USER 1001:1001
ENV NODE_ENV=production HOME=/tmp
CMD ["node", "dist/bot/main.js"]
