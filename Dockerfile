FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py game.py roads.py ./
COPY data ./data
COPY web ./web
RUN useradd --create-home taxi
USER taxi
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "exec python -m uvicorn app:app --host 0.0.0.0 --port \"$PORT\""]
