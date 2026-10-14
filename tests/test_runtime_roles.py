import pytest

from workbench.official_web import validate_runtime_role


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
