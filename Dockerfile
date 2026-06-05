FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs dashboard.html ./
ENV PORT=8080 DATA_FILE=/data/clicks.ndjson
RUN mkdir -p /data
EXPOSE 8080
CMD ["node","server.mjs"]
