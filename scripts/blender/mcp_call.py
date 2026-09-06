"""Call the installed STDIO MCP server, also usable before a client's tool catalog refreshes."""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tool")
    parser.add_argument("--json", default="{}")
    parser.add_argument("--code-file")
    parser.add_argument("--host", default=os.environ.get("BLENDER_HOST", "127.0.0.1"))
    parser.add_argument("--port", default=os.environ.get("BLENDER_PORT", "9877"))
    args = parser.parse_args()
    arguments = json.loads(args.json)
    if args.code_file:
        code_file = Path(args.code_file).resolve()
        arguments["code"] = f"__file__ = {str(code_file)!r}\n" + code_file.read_text(encoding="utf-8")
    env = dict(os.environ, BLENDER_HOST=args.host, BLENDER_PORT=str(args.port))
    launch = "import logging; logging.disable(logging.CRITICAL); from blendmcp.server import main; main()"
    async with stdio_client(StdioServerParameters(command=sys.executable, args=["-c", launch], env=env)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools() if args.tool == "list" else await session.call_tool(args.tool, arguments)
            print(result.model_dump_json(exclude_none=True))
            failed = getattr(result, "isError", False)
            # BlendMCP 1.4.3 reports execution failures as text with isError=false.
            if args.tool == "execute_blender_code":
                failed = failed or any(block.type == "text" and block.text.startswith(("Error executing code:", "Code execution failed:"))
                                       for block in result.content)
            return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
