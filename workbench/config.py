import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

@dataclass
class Settings:
    data_dir: Path
    token: str
    api_key: str
    base_url: str
    model: str
    profile: str
    patches: tuple[str, ...] = ()
    timeout: float = 900

    @classmethod
    def load(cls):
        load_dotenv()
        return cls(Path(os.getenv('WORKBENCH_DATA_DIR', './data')).resolve(),
                   os.getenv('WORKBENCH_TOKEN', ''), os.getenv('DEEPSEEK_API_KEY', ''),
                   os.getenv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
                   os.getenv('DSH_MODEL', 'deepseek-v4-flash'), os.getenv('DSH_PROFILE', 'sdk'),
                   tuple(str(Path(p).resolve()) for p in os.getenv('DSH_PATCHES', '').split(os.pathsep) if p),
                   float(os.getenv('WORKBENCH_RUN_TIMEOUT', '900')))
