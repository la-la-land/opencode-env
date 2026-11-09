#!/usr/bin/env bash
# opencode-env / honcho — tiktoken BPE-кэш для контейнеров honcho.
#
# ЗАЧЕМ. tiktoken при первом импорте тянет BPE-файлы с
# openaipublic.blob.core.windows.net. В этой сети домен режется прокси
# ("Application Control Violation"): DNS резолвится, TLS-хендшейк зависает,
# requests.get висит без таймаута — контейнер honcho-api не проходит старт
# (health-check уходит в unhealthy, /health не отвечает, MCP honcho таймаутится).
#
# ЧТО ДЕЛАЕТ. Кладёт в $CACHE_DIR два файла, которые tiktoken ищет по
# имени-ключу = sha1(URL файла):
#   fb374d419588a4632f3f557e76b4b70aebbca790 -> o200k_base.tiktoken
#   9b5ad71b2ce5302211f9c61530b329a4922fc6a4 -> cl100k_base.tiktoken
# Файлы берём из репозитория (honcho/.tiktoken-cache/), а cl100k при
# отсутствии пересобираем из HF tokenizer.json и сверяем sha256 с официальным.
#
# Оба файла — байт-в-байт официальные openai (sha256 сверены с expected_hash
# в tiktoken_ext/openai_public.py), поэтому tiktoken принимает их с первого
# чтения и сеть больше не нужна.
set -euo pipefail

CACHE_DIR="${1:-$HOME/honcho/.tiktoken-cache}"
REPO_CACHE="$(cd "$(dirname "$0")" && pwd)/.tiktoken-cache"

O200K_KEY="fb374d419588a4632f3f557e76b4b70aebbca790"   # sha1(o200k_base URL)
CL100K_KEY="9b5ad71b2ce5302211f9c61530b329a4922fc6a4"   # sha1(cl100k_base URL)
O200K_SHA="446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"
CL100K_SHA="223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7"

mkdir -p "$CACHE_DIR"

# 1) что уже есть — копируем из репозитория, если нет
for key in "$O200K_KEY" "$CL100K_KEY"; do
  if [ ! -f "$CACHE_DIR/$key" ] && [ -f "$REPO_CACHE/$key" ]; then
    cp "$REPO_CACHE/$key" "$CACHE_DIR/$key"
    echo "[ok] tiktoken: $key <- репозиторий"
  fi
done

# 2) нет файла в репозитории/на зеркале — o200k берём с HF (sha256 тот же)
hf_get() {  # hf_get <url> <dst> <name>
  local url="$1" dst="$2" name="$3"
  if curl -fsSL -m 120 -o "$dst" "$url"; then
    echo "[ok] tiktoken: $name <- Hugging Face"
  else
    rm -f "$dst"
    echo "[..] tiktoken: $name не отдался с HF ($url)"
  fi
}
if [ ! -f "$CACHE_DIR/$O200K_KEY" ]; then
  hf_get "https://huggingface.co/baseten/o200k-base-tiktoken/resolve/main/$O200K_KEY" \
         "$CACHE_DIR/$O200K_KEY" "o200k_base"
fi

# 3) cl100k_base: пересобрать из HF tokenizer.json, если файла нет
#    (прямого зеркала .tiktoken на HF нет; пересборка даёт байт-в-байт
#     официальный файл — sha256 223921b7... совпадает с expected_hash tiktoken)
if [ ! -f "$CACHE_DIR/$CL100K_KEY" ]; then
  echo "[..] tiktoken: cl100k_base отсутствует — пересобираем из HF"
  TMP="$(mktemp -d)"
  if curl -fsSL -m 60 -o "$TMP/tok.json" \
      "https://huggingface.co/DWDMaiMai/tiktoken_cl100k_base/resolve/main/tokenizer.json"; then
    python3 - "$TMP/tok.json" "$CACHE_DIR/$CL100K_KEY" <<'PY'
import base64, hashlib, json, sys

src, dst = sys.argv[1], sys.argv[2]
tj = json.load(open(src))

def bytes_to_unicode():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + \
         list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(2 ** 8):
        if b not in bs:
            bs.append(b); cs.append(2 ** 8 + n); n += 1
    return dict(zip(bs, [chr(c) for c in cs]))

u2b = {v: k for k, v in bytes_to_unicode().items()}
ranks = {}
for tok, tid in tj["model"]["vocab"].items():
    if tid >= 100256:          # added/special tokens не входят в mergeable ranks
        continue
    ranks[tid] = base64.b64encode(bytes(u2b[ch] for ch in tok)).decode()

assert sorted(ranks) == list(range(len(ranks))), "ranks не непрерывны"
blob = "".join(f"{ranks[r]} {r}\n" for r in range(len(ranks))).encode()
open(dst, "wb").write(blob)
print("   sha256:", hashlib.sha256(blob).hexdigest())
PY
  else
    rm -f "$CACHE_DIR/$CL100K_KEY"
    echo "[FAIL] tiktoken: не удалось скачать tokenizer.json с HF"
  fi
  rm -rf "$TMP"
fi

# 4) проверка sha256 против официальных значений tiktoken
fail=0
check() {
  local f="$CACHE_DIR/$1" want="$2" name="$3"
  if [ ! -f "$f" ]; then echo "[FAIL] tiktoken: $name отсутствует ($f)"; fail=1; return; fi
  local got
  got="$(sha256sum "$f" | cut -d' ' -f1)"
  if [ "$got" = "$want" ]; then
    echo "[ok] tiktoken: $name sha256 совпал"
  else
    echo "[FAIL] tiktoken: $name sha256 $got != $want"; fail=1
  fi
}
check "$O200K_KEY"  "$O200K_SHA"  "o200k_base"
check "$CL100K_KEY" "$CL100K_SHA" "cl100k_base"

if [ "$fail" -ne 0 ]; then
  echo "[fail] tiktoken-кэш неполон — honcho-api зависнет на старте"
  exit 1
fi
echo "[ok] tiktoken-кэш готов: $CACHE_DIR"
