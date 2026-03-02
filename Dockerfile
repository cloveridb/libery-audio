FROM node:20-slim

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
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
