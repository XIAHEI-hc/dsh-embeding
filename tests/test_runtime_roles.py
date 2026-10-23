import pytest

from workbench.official_web import initialize_runner_workspace, inject_secret_file, validate_runtime_role


def test_runner_rejects_control_plane_secret():
    env = {
        "WORKBENCH_ROLE": "runner",
        "WORKBENCH_INTEGRATION_MODE": "embedded_multi_user",
        "WORKBENCH_RUNNER_BROKER_ORIGIN": "http://gateway:8765",
        "WORKBENCH_RUNNER_CREDENTIAL_FILE": "/private/runner-credential",
        "DSH_HOME": "/data/dsh-home",
        "WORKBENCH_WEB_WORKSPACE": "/workdir/repository",
        "MEMORYLAB_AI_TOOL_SECRET": "should-never-be-here",
    }
    with pytest.raises(ValueError, match="禁止继承"):
        validate_runtime_role(env)


def test_multi_user_gateway_requires_registry():
    env = {"WORKBENCH_ROLE": "gateway", "WORKBENCH_INTEGRATION_MODE": "embedded_multi_user"}
    with pytest.raises(ValueError, match="RUNTIME_REGISTRY"):
        validate_runtime_role(env)


def test_standalone_role_is_compatible_without_multi_user_settings():
    assert validate_runtime_role({"WORKBENCH_ROLE": "standalone"}) == "standalone"


def test_standalone_role_rejects_stale_host_integrations():
    with pytest.raises(ValueError, match="禁止启用宿主集成"):
        validate_runtime_role({
            "WORKBENCH_ROLE": "standalone",
            "MEMORYLAB_AI_INTEGRATION_ENABLED": "true",
        })


def test_standalone_role_rejects_embedded_mode():
    with pytest.raises(ValueError, match="不能使用 embedded"):
        validate_runtime_role({
            "WORKBENCH_ROLE": "standalone",
            "WORKBENCH_INTEGRATION_MODE": "embedded_multi_user",
        })


def test_legacy_no_role_configuration_remains_compatible():
    assert validate_runtime_role({
        "MEMORYLAB_AI_INTEGRATION_ENABLED": "true",
        "WORKBENCH_INTEGRATION_MODE": "embedded_single_user_legacy",
    }) == "standalone"


def test_runner_workspace_is_seeded_once_without_overwriting_user_files(tmp_path):
    seed = tmp_path / "seed"
    workspace = tmp_path / "workspace"
    seed.mkdir()
    (seed / "README.md").write_text("base")
    assert initialize_runner_workspace(workspace, seed, "runner") is True
    assert (workspace / "README.md").read_text() == "base"
    (workspace / "user.txt").write_text("private")
    (seed / "README.md").write_text("changed-seed")
    assert initialize_runner_workspace(workspace, seed, "runner") is False
    assert (workspace / "README.md").read_text() == "base"
    assert (workspace / "user.txt").read_text() == "private"


def test_runner_workspace_requires_seed_directory(tmp_path):
    with pytest.raises(RuntimeError, match="seed"):
        initialize_runner_workspace(tmp_path / "workspace", tmp_path / "missing", "runner")


@pytest.mark.parametrize('name', ['gateway.env', '.env', '.env.production', 'runtime-secrets.json', 'model.key'])
def test_runner_workspace_rejects_control_seed_before_copying(tmp_path, name):
    seed = tmp_path / 'seed'
    seed.mkdir()
    (seed / 'README.md').write_text('ordinary content')
    (seed / name).write_text('test-only placeholder')
    workspace = tmp_path / 'workspace'
    with pytest.raises(RuntimeError, match='deployment'):
        initialize_runner_workspace(workspace, seed, 'runner')
    assert list(workspace.iterdir()) == []
    assert (seed / name).exists()


def test_model_secret_file_is_injected_without_exposing_file_contents(tmp_path):
    secret_file = tmp_path / "deepseek-api-key"
    secret_file.write_text("  key-for-runner-a\n", encoding="utf-8")
    env = {"DEEPSEEK_API_KEY_FILE": str(secret_file)}
    assert inject_secret_file(env, "DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY_FILE") is True
    assert env["DEEPSEEK_API_KEY"] == "key-for-runner-a"


def test_explicit_model_secret_takes_precedence_over_secret_file(tmp_path):
    secret_file = tmp_path / "deepseek-api-key"
    secret_file.write_text("file-value", encoding="utf-8")
    env = {"DEEPSEEK_API_KEY": "env-value", "DEEPSEEK_API_KEY_FILE": str(secret_file)}
    assert inject_secret_file(env, "DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY_FILE") is False
    assert env["DEEPSEEK_API_KEY"] == "env-value"


def test_empty_model_secret_file_fails_closed(tmp_path):
    secret_file = tmp_path / "deepseek-api-key"
    secret_file.write_text("\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="为空"):
        inject_secret_file({"DEEPSEEK_API_KEY_FILE": str(secret_file)}, "DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY_FILE")
