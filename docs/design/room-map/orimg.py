#!/usr/bin/env python3
"""Generate images through OpenRouter.

The key is read from OPENROUTER_API_KEY and is never written to disk by this
script. Reference images are inlined as base64 data URLs.

  orimg.py --prompt "..." --out plate.png [--ref photo.jpg ...] [--model ...]
"""
import argparse, base64, json, mimetypes, os, sys, urllib.request

ENDPOINT = "https://openrouter.ai/api/v1/images"
DEFAULT_MODEL = "google/gemini-3-pro-image"


def data_url(path):
    mime = mimetypes.guess_type(path)[0] or "image/png"
    with open(path, "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref", action="append", default=[])
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--dump", action="store_true", help="print response keys")
    args = ap.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("OPENROUTER_API_KEY is not set")

    body = {"model": args.model, "prompt": args.prompt}
    if args.ref:
        body["input_references"] = [
            {"type": "image_url", "image_url": {"url": data_url(p)}} for p in args.ref
        ]

    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://renatodap.me/vue-automation",
            "X-Title": "Vue Lights room map",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            payload = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode()[:2000]}")

    if args.dump:
        print("top-level keys:", list(payload.keys()))
        if payload.get("data"):
            print("data[0] keys:", list(payload["data"][0].keys()))
        print("usage:", json.dumps(payload.get("usage", {})))

    items = payload.get("data") or []
    if not items:
        sys.exit(f"no image in response: {json.dumps(payload)[:2000]}")

    b64 = items[0].get("b64_json") or items[0].get("image_base64")
    if not b64:
        url = (items[0].get("image_url") or {}).get("url", "")
        if url.startswith("data:"):
            b64 = url.split(",", 1)[1]
    if not b64:
        sys.exit(f"unrecognised item shape: {list(items[0].keys())}")

    with open(args.out, "wb") as f:
        f.write(base64.b64decode(b64))
    cost = (payload.get("usage") or {}).get("cost")
    print(f"wrote {args.out} ({os.path.getsize(args.out)} bytes)" + (f"  cost=${cost}" if cost else ""))


if __name__ == "__main__":
    main()
