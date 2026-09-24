FROM python:3.13-slim
RUN pip install --no-cache-dir pytest==9.1.1 pytest-json-ctrf==0.5.2
COPY . /tests/
COPY expected/ /app/expected/
RUN mkdir -p /app /output /logs/verifier
