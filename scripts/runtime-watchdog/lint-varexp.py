#!/usr/bin/env python3
"""lint-varexp.py —— 检出 `$VAR` 紧邻非 ASCII 字符的写法。

为什么需要它：
  在 UTF-8 locale 下 bash 会把紧随其后的多字节字符并入变量名 ——
  `"$f（原件备份"` 里的变量名是 `f（` 而不是 `f`，配合 `set -u`
  直接以 `f（: unbound variable` 终止整个脚本。

  这是一个**只在中文输出路径上才触发**的静默杀手：英文环境下永远不犯，
  一旦触发就是脚本中途死亡、后续修复全部跳过。本工具包开发过程中它在
  verify.sh / freeze.sh / heal.sh 里各咬过一次，因此固化为静态检查。

用法：lint-varexp.py FILE...   有命中则退出码 1
"""
import io
import re
import sys

PATTERN = re.compile(r'(?<!\\)\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7f])')


def scan(line):
    """只检查真正会被展开的位置。

    排除两类误报：
      1. 注释行 —— bash 从不展开注释；
      2. 转义的 `\\$` 与单引号内的字面量 —— 都不会展开。
    宁可精确：一个会误报的 lint 最终会被无视。
    """
    if line.lstrip().startswith('#'):
        return
    # 单引号内是字面量，按引号切成段，只扫描引号外的部分（保守近似）
    for index, segment in enumerate(line.split("'")):
        if index % 2 == 1:
            continue
        for match in PATTERN.finditer(segment):
            yield match


def main(paths):
    hits = 0
    for path in paths:
        try:
            lines = io.open(path, encoding='utf-8').read().splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(lines, 1):
            for match in scan(line):
                name = match.group(0)[1:]
                print(f'{path}:{number}: {match.group(0)}紧邻非 ASCII → 应写作 ${{{name}}}')
                hits += 1
    if hits:
        print(f'\n共 {hits} 处：变量名会被中文吞掉，set -u 下脚本直接终止')
        return 1
    print('未发现 $VAR 紧邻非 ASCII 的写法')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
