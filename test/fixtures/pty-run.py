# Run a planhop command in a real pseudo-terminal, answering each question in
# turn, and report whether every question actually waited for its answer.
# usage: pty-run.py <cli.js> <home> <answer>... -- <planhop args>...
import os, pty, sys, time
cli, home = sys.argv[1], sys.argv[2]
rest = sys.argv[3:]
split = rest.index("--")
answers, args = rest[:split], rest[split + 1:]
env = dict(os.environ, HOME=home, SHELL="/bin/bash")
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", cli] + args, env)
out = b""
asked = 0
waited_all = True
deadline = time.time() + 20
prompts = (b"[Y/n] ", b"Choose [1]: ", b"Choose [3]: ")
while time.time() < deadline:
    try:
        chunk = os.read(fd, 1024)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    pending = sum(out.count(p) for p in prompts)
    while asked < pending:
        size = len(out)
        time.sleep(0.4)  # a question that doesn't wait would print more meanwhile
        try:
            os.set_blocking(fd, False)
            extra = os.read(fd, 1024)
        except (BlockingIOError, OSError):
            extra = b""
        finally:
            os.set_blocking(fd, True)
        out += extra
        if extra.strip():
            waited_all = False
        answer = answers[asked] if asked < len(answers) else "n"
        os.write(fd, answer.encode() + b"\n")
        asked += 1
os.waitpid(pid, 0)
print("questions:", asked, "all waited:", waited_all)
print(out.decode(errors="replace").replace("\r", "").strip())
