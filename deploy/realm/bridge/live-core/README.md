# Funded core integration design — not installed

This directory contains the source-backed design and first implementation plan for an actual C++ funded-world adapter. It contains no runtime hook, activation flag, route, money grant, signer or applied SQL. The existing TEST bridge and tested private binary are unchanged. The closed JavaScript accounting fixtures are not integration with stock gameplay.

Read [DESIGN.md](DESIGN.md) for the contract and unavoidable core changes, then [PLAN.md](PLAN.md) for the vendor-sale vertical slice and its acceptance tests. Source references are to unmodified CMaNGOS Classic `de8f72993b9e1faa1bf92dd5505f3daec5cea3ce`, verified against the sibling source [audit](../audit/README.md). All proposed C++/SQL filenames describe future files; none are implemented here.

Implementation requires coordinator ownership of an isolated source patch/build and review. A successful first slice would prove only that slice in a disposable database/core. It would not admit stock currency, enable other handlers or authorize a production rollout.
