from pathlib import Path


def test_private_runner_compose_does_not_mount_shared_seed():
    compose = Path('examples/deploy/compose.private-runners.yaml').read_text(encoding='utf-8')
    assert 'MEMORYLAB_SEED_DIR' not in compose
    assert 'target: /seed' not in compose


def test_private_runner_templates_use_runner_local_seed():
    for name in ('runner-a.env', 'runner-b.env'):
        text = Path('examples/deploy/private', name).read_text(encoding='utf-8')
        assert 'WORKBENCH_SEED_DIR=/private/seed' in text
