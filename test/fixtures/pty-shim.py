# Run `planhop shim` in a real pseudo-terminal, answer the question, report what happened.
import os, pty, sys, time, tempfile, shutil
cli, answer = sys.argv[1], sys.argv[2]
home = tempfile.mkdtemp()
open(os.path.join(home, ".bashrc"), "w").write("# existing\n")
env = dict(os.environ, HOME=home, SHELL="/bin/bash")
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", cli, "shim"], env)
out = b""
deadline = time.time() + 15
sent = False
waited = False
while time.time() < deadline:
    try:
        chunk = os.read(fd, 1024)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not sent and b"[Y/n]" in out:
        time.sleep(0.5)          # prove it waits rather than moving on by itself
        waited = b"Not changed" not in out and b"Added" not in out
        os.write(fd, answer.encode() + b"\n")
        sent = True
os.waitpid(pid, 0)
text = out.decode(errors="replace").replace("\r", "")
print("waited for the answer:", waited if sent else "never asked")
print(text.strip())
shutil.rmtree(home)
