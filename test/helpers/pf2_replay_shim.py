"""PF-2 S4 test-only entry point. Production code never imports or runs this file.

It runs robot_quant.pf2_replay.main() from the pinned source root. Only the enrollment step
(CustomOptimizationPlan.from_snapshot) is replaced, and only for the synthetic test source:
the real signal source is private and absent from this repository. The SPT evaluator, Bridge,
Risk, PaperState, checkpoint and IPC code stay real. The replacement uses the S1 real_spt input
values. Everything else calls the original method.
"""
import hashlib
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
# Script mode puts this directory first on sys.path; it must never shadow the pinned source root.
sys.path[:] = [entry for entry in sys.path if os.path.abspath(entry) != _HERE]

SYNTHETIC_PREFIX = b'//@version=6\nindicator("PF2 synthetic"'


def _record_pid():
    """Kill proof for the tests: only when the test created the enable sentinel in the temp dir."""
    try:
        folder = tempfile.gettempdir()
        if not os.path.exists(os.path.join(folder, "pf2-shim.enable")):
            return
        target = os.path.join(folder, "pf2-shim.pid")
        scratch = "{}.{}.tmp".format(target, os.getpid())
        with open(scratch, "w") as handle:
            handle.write(str(os.getpid()))
        os.replace(scratch, target)
    except OSError:
        pass


def _install():
    from robot_quant.spt_custom_evaluator import CustomOptimizationPlan, CustomSignalInputs

    original = CustomOptimizationPlan.from_snapshot

    def from_snapshot(source, snapshot):
        # `source` arrives as bytes (pf2_replay.build_signal_source encodes it).
        if (
            isinstance(source, bytes)
            and source.startswith(SYNTHETIC_PREFIX)
            and isinstance(snapshot, dict)
            and snapshot.get("source_hash") == hashlib.sha256(source).hexdigest()
        ):
            inputs = CustomSignalInputs(
                ema_fast=5, ema_slow=17, atr_len=7, st_factor=1.2, zone_atr_mult=2.5,
                setup_expiry=8, cooldown=2, confirm_lookback=3,
            )
            return CustomOptimizationPlan(inputs, {})
        return original(source, snapshot)

    CustomOptimizationPlan.from_snapshot = staticmethod(from_snapshot)


def main():
    _record_pid()
    from robot_quant import pf2_replay

    _install()
    pf2_replay.main()


if __name__ == "__main__":
    main()
