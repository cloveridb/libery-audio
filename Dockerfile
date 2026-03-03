FROM node:20-slim

# Install FFmpeg only (yt-dlp handled by npm package youtube-dl-exec)
RUN apt-get update && \
    apt-get install -y ffmpeg python3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy all files
COPY . .

# Create data directory
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "server.js"]
