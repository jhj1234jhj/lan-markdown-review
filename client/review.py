#!/usr/bin/env python3
"""共阅客户端：把 Markdown 推到评审服务，或取回最新稿与意见。

用法示例：
    review.py register --account hjh --name 何建华
    review.py submit 方案.md --token $REVIEW_TOKEN
    review.py latest  r7k2m9qd --out 最新稿.md
    review.py comments r7k2m9qd
    review.py list --account hjh --since 2026-11-01

token 也可以通过环境变量 REVIEW_TOKEN 提供，服务地址用 REVIEW_BASE（默认 http://127.0.0.1:6767）。
仅依赖标准库。
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

DEFAULT_BASE = os.environ.get("REVIEW_BASE", "http://127.0.0.1:6767").rstrip("/")
TOKEN_ENV = "REVIEW_TOKEN"
IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
IMAGE_PATTERN = re.compile(r"!\[[^\]]*\]\(([^)\s]+)")


def die(message, code=1):
    print(f"错误：{message}", file=sys.stderr)
    raise SystemExit(code)


def request(base, method, path, body=None, token=None, raw=False):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if method not in ("GET", "HEAD"):
        # 服务端要求写请求带这个头，浏览器跨站表单无法伪造。
        headers["X-Review-Request"] = "1"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            payload = response.read()
            if raw:
                return payload, dict(response.headers)
            return json.loads(payload.decode("utf-8") or "null"), dict(response.headers)
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(payload).get("error", payload)
        except json.JSONDecodeError:
            message = payload
        die(f"服务返回 {error.code}：{message}")
    except urllib.error.URLError as error:
        die(f"连不上 {base}：{error.reason}")


def resolve_token(args):
    return args.token or os.environ.get(TOKEN_ENV) or ""


def normalize_asset_path(value):
    path = value.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def collect_assets(markdown, base_dir, extra):
    """把正文里引用的本地图片读成 base64，路径保持与正文写法一致。"""
    assets, seen = [], set()
    candidates = [normalize_asset_path(m.group(1)) for m in IMAGE_PATTERN.finditer(markdown)]
    candidates += [normalize_asset_path(item) for item in extra]
    for relative in candidates:
        if not relative or relative in seen:
            continue
        if relative.startswith(("http://", "https://", "//", "data:")):
            continue
        file = (base_dir / relative).resolve()
        if not file.is_file():
            print(f"提示：正文引用的图片 {relative} 不存在，已跳过", file=sys.stderr)
            continue
        mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if mime not in IMAGE_MIMES:
            print(f"提示：{relative} 不是 PNG/JPEG/WebP/GIF，已跳过", file=sys.stderr)
            continue
        seen.add(relative)
        assets.append({
            "path": relative,
            "mime": mime,
            "data": base64.b64encode(file.read_bytes()).decode("ascii"),
        })
    return assets


def human_time(value):
    if not value:
        return "-"
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().strftime("%m-%d %H:%M")
    except ValueError:
        return value


def cmd_register(args):
    body = {"account": args.account, "name": args.name or args.account}
    token, _ = request(args.base, "POST", "/api/accounts", body, token=args.token or None)
    print(f"账号：{token['account']}（{token['name']}）")
    print(f"token：{token['token']}")
    print("token 只在这一次返回，请保存到环境变量 REVIEW_TOKEN 或密码管理器。")


def cmd_submit(args):
    markdown_path = Path(args.file)
    if not markdown_path.is_file():
        die(f"文件不存在：{markdown_path}")
    markdown = markdown_path.read_text(encoding="utf-8")
    if not markdown.strip():
        die("文件是空的")
    token = resolve_token(args)
    if not token:
        die("缺少 token：传 --token，或设置环境变量 REVIEW_TOKEN")
    assets = collect_assets(markdown, markdown_path.parent, args.attach)
    body = {
        "filename": markdown_path.name,
        "sourcePath": markdown_path.name,
        "markdown": markdown,
        "assets": assets,
    }
    if args.title:
        body["title"] = args.title
    created, _ = request(args.base, "POST", "/api/service/documents", body, token=token)
    if args.json:
        print(json.dumps(created, ensure_ascii=False, indent=2))
        return
    print(f"已提交：{created['title']}")
    print(f"短 id：{created['shortId']}   版本：v{created['version']}")
    print(f"评审地址：{args.base}{created['url']}")


def cmd_latest(args):
    query = "?include=content" + (f"&v={args.version}" if args.version else "")
    document, _ = request(args.base, "GET", f"/api/service/documents/{urllib.parse.quote(args.ref)}{query}")
    content = document.get("content", "")
    if args.out:
        Path(args.out).write_text(content, encoding="utf-8")
        print(f"{document['title']} · v{document['version']} → {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(content)
    if args.json:
        document.pop("content", None)
        print(json.dumps(document, ensure_ascii=False, indent=2), file=sys.stderr)


def cmd_comments(args):
    query = "?include=comments" + (f"&v={args.version}" if args.version else "")
    document, _ = request(args.base, "GET", f"/api/service/documents/{urllib.parse.quote(args.ref)}{query}")
    comments = document.get("comments", [])
    if args.json:
        print(json.dumps({"document": {k: v for k, v in document.items() if k != "comments"}, "comments": comments}, ensure_ascii=False, indent=2))
        return
    labels = {"pending": "未批注", "agreed": "同意", "rejected": "拒绝"}
    counts = {"pending": 0, "agreed": 0, "rejected": 0}
    for comment in comments:
        counts[comment["status"]] = counts.get(comment["status"], 0) + 1
    print(f"{document['title']} · v{document['version']} · 共 {len(comments)} 条意见（未批注 {counts['pending']} · 同意 {counts['agreed']} · 拒绝 {counts['rejected']}）")
    for index, comment in enumerate(comments, 1):
        status = labels.get(comment["status"], comment["status"])
        quote = (comment.get("quote") or "").replace("\n", " ")
        if len(quote) > 60:
            quote = quote[:60] + "…"
        print(f"\n{index}. [{status}] {comment['author']} · {human_time(comment['created'])}")
        print(f"   引用：{quote or '（整体建议）'}")
        for line in comment["body"].splitlines() or [""]:
            print(f"   {line}")
        for reply in comment.get("replies", []):
            print(f"   ↳ {reply['author']}：{reply['body']}")


def cmd_list(args):
    params = {}
    if args.account:
        params["account"] = args.account
    if args.since:
        params["since"] = args.since
    if args.until:
        params["until"] = args.until
    if args.limit:
        params["limit"] = str(args.limit)
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    documents, _ = request(args.base, "GET", f"/api/service/documents{query}")
    if args.json:
        print(json.dumps(documents, ensure_ascii=False, indent=2))
        return
    if not documents:
        print("没有匹配的文档")
        return
    print(f"{'短 id':10} {'版本':4} {'未批注':6} {'更新':12} {'账号':14} 标题")
    for doc in documents:
        owner = doc["owner"].get("account") or doc["owner"].get("name") or "-"
        print(f"{doc['shortId']:10} v{doc['latest']:<3} {doc['openCount']:<6} {human_time(doc['updated']):12} {owner[:14]:14} {doc['title']}")


def main():
    # 公共参数既能写在子命令前，也能写在子命令后；写在后面时用 SUPPRESS 避免覆盖前面的值。
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base", default=argparse.SUPPRESS, help="服务地址")
    common.add_argument("--token", default=argparse.SUPPRESS, help="Bearer token")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="输出原始 JSON")

    parser = argparse.ArgumentParser(prog="review.py", description="共阅：局域网 Markdown 评审客户端")
    parser.add_argument("--base", default=DEFAULT_BASE, help=f"服务地址（默认 {DEFAULT_BASE}）")
    parser.add_argument("--token", default=os.environ.get(TOKEN_ENV), help="Bearer token（默认读 REVIEW_TOKEN）")
    parser.add_argument("--json", action="store_true", help="输出原始 JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    register = sub.add_parser("register", parents=[common], help="注册账号并拿到 token")
    register.add_argument("--account", required=True, help="账号，2–40 位小写字母/数字/._-")
    register.add_argument("--name", help="显示姓名，默认与账号相同")
    register.set_defaults(func=cmd_register)

    submit = sub.add_parser("submit", parents=[common], help="把 Markdown 提交到服务")
    submit.add_argument("file", help="Markdown 文件路径")
    submit.add_argument("--title", help="自定义标题，默认取第一个 # 标题")
    submit.add_argument("--attach", action="append", default=[], help="额外附加的图片路径（可多次）")
    submit.set_defaults(func=cmd_submit)

    latest = sub.add_parser("latest", parents=[common], help="取回文档最新稿")
    latest.add_argument("ref", help="短 id 或完整 id")
    latest.add_argument("--version", type=int, help="指定版本，默认最新")
    latest.add_argument("--out", help="写入文件而不是打印到终端")
    latest.set_defaults(func=cmd_latest)

    comments = sub.add_parser("comments", parents=[common], help="取回文档的意见")
    comments.add_argument("ref", help="短 id 或完整 id")
    comments.add_argument("--version", type=int, help="指定版本，默认最新")
    comments.set_defaults(func=cmd_comments)

    listing = sub.add_parser("list", parents=[common], help="列出文档，可按账号和时间过滤")
    listing.add_argument("--account", help="按账号过滤")
    listing.add_argument("--since", help="起始时间，ISO 8601 或毫秒时间戳")
    listing.add_argument("--until", help="截止时间，ISO 8601 或毫秒时间戳")
    listing.add_argument("--limit", type=int, default=50, help="最多返回多少条，默认 50")
    listing.set_defaults(func=cmd_list)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
