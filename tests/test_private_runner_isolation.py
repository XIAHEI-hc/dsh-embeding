from pathlib import Path


def test_private_runner_compose_does_not_mount_shared_seed():
    compose = Path('examples/deploy/compose.private-runners.yaml').read_text(encoding='utf-8')
    assert 'MEMORYLAB_SEED_DIR' not in compose
    assert 'target: /seed' not in compose


def test_bootstrap_generates_runner_local_seed_path():
    text = Path('scripts/bootstrap-private-runtime.mjs').read_text(encoding='utf-8')
    assert "join(root, 'runner-a', 'seed')" in text
    assert "join(root, 'runner-b', 'seed')" in text
    assert "WORKBENCH_SEED_DIR=/private/seed" in text
