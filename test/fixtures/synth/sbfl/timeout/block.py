"""Blocks SIGALRM and spins: the in-child alarm cannot fire, so only the parent's kill ends it."""
import signal


def block():
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
    n = 0
    while True:
        n += 1
