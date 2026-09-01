"""Signal layer: source actions → qualification → sizing → shadow fills.

The copy pipeline. Turns "a wallet we follow just traded" into "here is
what we would have done, and why" — and records the why whether or not
anything happened, because the rejection histogram is the evidence the
shadow gate consumes.
"""
