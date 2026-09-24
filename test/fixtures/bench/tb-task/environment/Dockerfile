FROM python:3.13-slim
WORKDIR /app
RUN pip install --no-cache-dir pyyaml==6.0.2
COPY prog.py ./
COPY data/ ./data/
RUN mkdir -p /output && echo seed > /app/seed.txt
