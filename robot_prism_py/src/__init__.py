"""Implementation packages for robot_prism: core, sim and ui.

Dependency flow is one-way: ``core`` (data + math) <- ``sim`` (the simulation)
<- ``ui`` (presentation + input). The public surface is re-exported from the
top-level ``robot_prism_py`` package.
"""
