"""Entry point: ``python -m robot_prism_py [--selftest]``."""

import sys


def main():
    if "--selftest" in sys.argv:
        from .selftest import selftest
        sys.exit(0 if selftest() else 1)
    try:
        from .gui import run_gui
        run_gui()
    except Exception as exc:
        print("Could not start the GUI:", exc)
        print("If tkinter is missing: Debian/Ubuntu -> sudo apt install python3-tk")
        print("Engine check still works: python -m robot_prism_py --selftest")


if __name__ == "__main__":
    main()
