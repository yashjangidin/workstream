FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY services/api ./services/api
RUN npm install --ignore-scripts
RUN npm run build --workspace=@workstream/api
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["node", "--import", "tsx", "services/api/dist/src/server.js"]
