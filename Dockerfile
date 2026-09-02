FROM python:3.11-slim

# Prevent Python from writing .pyc files and buffer outputs
ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PORT=8000

WORKDIR /app

# Install system dependencies required for Playwright / Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    ca-certificates \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libxkbcommon0 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browser and dependencies
RUN playwright install --with-deps chromium

# Copy application files
COPY . .

# Ensure user_data directory exists
RUN mkdir -p /app/user_data

# Expose port
EXPOSE 8000

# Start FastAPI application
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --loop asyncio"]
