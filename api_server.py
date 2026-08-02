import os
import json
import shutil
import tempfile
import subprocess
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

LS_BIN = Path(__file__).resolve().parent / "bin" / "lsc"

app = FastAPI(
    title="Lunascripts API",
    description="Compile, decompile, validate, and fix Lunascripts (LS) files via HTTP.",
    version="1.2.0",
)


def _run_ls(*args: str, workdir: Optional[str] = None, timeout: int = 30) -> subprocess.CompletedProcess:
    cmd = [str(LS_BIN), *args]
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=workdir,
        timeout=timeout,
    )


# ── /compile (single file) ──────────────────────────────────────────────

@app.post("/compile")
async def compile_script(
    script: UploadFile = File(..., description="LS script file (.ls or .ls.md)"),
    assets: Optional[UploadFile] = File(default=None, description="Optional assets mapping JSON file"),
):
    """
    Compile a single LS script (.ls or .ls.md) into structured JSON.

    Returns the compiled episode JSON. If an assets mapping is provided,
    asset semantic names are resolved to full URLs.
    """
    tmpdir = tempfile.mkdtemp(prefix="ls_compile_")
    try:
        script_bytes = await script.read()
        script_text = script_bytes.decode("utf-8")
        script_path = os.path.join(tmpdir, "script.ls.md")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script_text)

        args = ["compile", script_path, "-o", os.path.join(tmpdir, "output.json")]

        if assets is not None:
            assets_bytes = await assets.read()
            assets_text = assets_bytes.decode("utf-8")
            assets_path = os.path.join(tmpdir, "assets.json")
            with open(assets_path, "w", encoding="utf-8") as f:
                f.write(assets_text)
            args.insert(2, "--assets")
            args.insert(3, assets_path)

        proc = _run_ls(*args, timeout=30)

        if proc.returncode != 0:
            raise HTTPException(status_code=422, detail={"error": proc.stderr.strip()})

        output_path = os.path.join(tmpdir, "output.json")
        with open(output_path, "r", encoding="utf-8") as f:
            result = json.load(f)

        return JSONResponse(content=result)

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Compilation timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── /compile-dir (directory via zip) ────────────────────────────────────

@app.post("/compile-dir")
async def compile_directory(
    zipfile_upload: UploadFile = File(..., alias="zipfile", description="Zip archive of an LS episode directory"),
    assets: Optional[UploadFile] = File(default=None, description="Optional assets mapping JSON file"),
):
    """
    Compile an entire episode directory (uploaded as a zip) into structured JSON.

    The zip should contain one or more `.ls` / `.ls.md` files (e.g. 01.ls.md, 02.ls.md, …).
    Directory structure inside the zip is flattened — all `.ls` / `.ls.md` / `.episode.ls` / `.episode.ls.md` files are
    discovered recursively and compiled together.

    Returns the compiled novel JSON (keyed by episode_id).
    """
    tmpdir = tempfile.mkdtemp(prefix="ls_compiledir_")
    try:
        zip_bytes = await zipfile_upload.read()
        zip_path = os.path.join(tmpdir, "input.zip")
        with open(zip_path, "wb") as f:
            f.write(zip_bytes)

        episode_dir = os.path.join(tmpdir, "episodes")
        os.makedirs(episode_dir)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(episode_dir)

        args = ["compile", episode_dir, "-o", os.path.join(tmpdir, "output.json")]

        if assets is not None:
            assets_bytes = await assets.read()
            assets_text = assets_bytes.decode("utf-8")
            assets_path = os.path.join(tmpdir, "assets.json")
            with open(assets_path, "w", encoding="utf-8") as f:
                f.write(assets_text)
            args.insert(2, "--assets")
            args.insert(3, assets_path)

        proc = _run_ls(*args, timeout=60)

        if proc.returncode != 0:
            raise HTTPException(status_code=422, detail={"error": proc.stderr.strip()})

        output_path = os.path.join(tmpdir, "output.json")
        with open(output_path, "r", encoding="utf-8") as f:
            result = json.load(f)

        return JSONResponse(content=result)

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Directory compilation timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── /decompile ──────────────────────────────────────────────────────────

@app.post("/decompile")
async def decompile_json(
    compiled: UploadFile = File(..., description="Compiled LS JSON file"),
):
    """
    Decompile compiled LS JSON back into LS script and asset mapping.

    Returns the reconstructed LS source (.ls.md) and the recovered asset mapping.
    """
    tmpdir = tempfile.mkdtemp(prefix="ls_decompile_")
    try:
        compiled_bytes = await compiled.read()
        compiled_text = compiled_bytes.decode("utf-8")
        input_path = os.path.join(tmpdir, "input.json")
        with open(input_path, "w", encoding="utf-8") as f:
            f.write(compiled_text)

        output_dir = os.path.join(tmpdir, "decompiled")

        proc = _run_ls("decompile", input_path, "-o", output_dir, timeout=30)

        warnings = []
        if proc.stderr.strip():
            for line in proc.stderr.strip().split("\n"):
                line = line.strip()
                if line.startswith("warning:"):
                    warnings.append(line.removeprefix("warning:").strip())
                elif line.startswith("wrote"):
                    pass
                elif line:
                    warnings.append(line)

        if not os.path.isdir(output_dir):
            raise HTTPException(
                status_code=422,
                detail={"error": proc.stderr.strip() or "Decompilation produced no output"},
            )

        ls_files = {}
        mapping = None
        for fname in os.listdir(output_dir):
            fpath = os.path.join(output_dir, fname)
            if (
                fname.endswith(".ls")
                or fname.endswith(".ls.md")
                or fname.endswith(".episode.ls")
                or fname.endswith(".episode.ls.md")
            ):
                with open(fpath, "r", encoding="utf-8") as f:
                    ls_files[fname] = f.read()
            elif fname.endswith(".json"):
                with open(fpath, "r", encoding="utf-8") as f:
                    mapping = json.load(f)

        return JSONResponse(
            content={
                "episodes": ls_files,
                "asset_mapping": mapping,
                "warnings": warnings,
            }
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Decompilation timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── /validate ───────────────────────────────────────────────────────────

@app.post("/validate")
async def validate_script(
    script: UploadFile = File(..., description="LS script file (.ls or .ls.md) to validate"),
    assets: Optional[UploadFile] = File(default=None, description="Optional assets mapping JSON file"),
):
    """
    Validate an LS script for syntax errors without compiling.

    Returns a validation report: valid (true/false) and any error messages.
    """
    tmpdir = tempfile.mkdtemp(prefix="ls_validate_")
    try:
        script_bytes = await script.read()
        script_text = script_bytes.decode("utf-8")
        script_path = os.path.join(tmpdir, "script.ls.md")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script_text)

        args = ["validate", script_path]

        if assets is not None:
            assets_bytes = await assets.read()
            assets_text = assets_bytes.decode("utf-8")
            assets_path = os.path.join(tmpdir, "assets.json")
            with open(assets_path, "w", encoding="utf-8") as f:
                f.write(assets_text)
            args.append("--assets")
            args.append(assets_path)

        proc = _run_ls(*args, timeout=30)

        return JSONResponse(
            content={
                "valid": proc.returncode == 0,
                "errors": proc.stderr.strip() if proc.returncode != 0 else None,
                "stdout": proc.stdout.strip() or None,
            }
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Validation timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── /fix ────────────────────────────────────────────────────────────────

@app.post("/fix")
async def fix_script(
    script: UploadFile = File(..., description="LS script file (.ls or .ls.md) to fix"),
    check: bool = Query(default=False, description="Dry-run: report issues without writing changes"),
):
    """
    Auto-fix common issues in an LS script.

    In fix mode (default): returns the fixed script text and a list of
    fixes applied.

    In check mode (?check=true): returns a list of issues found without
    modifying the script (like `lsc fix --check`).
    """
    tmpdir = tempfile.mkdtemp(prefix="ls_fix_")
    try:
        script_bytes = await script.read()
        script_text = script_bytes.decode("utf-8")
        script_path = os.path.join(tmpdir, "script.ls.md")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(script_text)

        if check:
            proc = _run_ls("fix", script_path, "--check", timeout=30)
            return JSONResponse(
                content={
                    "check": True,
                    "issues_found": proc.returncode != 0,
                    "report": proc.stderr.strip() or proc.stdout.strip() or None,
                }
            )
        else:
            output_path = os.path.join(tmpdir, "fixed.ls.md")
            proc = _run_ls("fix", script_path, "-o", output_path, timeout=30)

            if proc.returncode != 0 and not os.path.exists(output_path):
                raise HTTPException(status_code=422, detail={"error": proc.stderr.strip()})

            if os.path.exists(output_path):
                with open(output_path, "r", encoding="utf-8") as f:
                    fixed_text = f.read()
            else:
                fixed_text = script_text  # unchanged

            return JSONResponse(
                content={
                    "check": False,
                    "fixed": fixed_text,
                    "changed": fixed_text != script_text,
                    "stderr": proc.stderr.strip() or None,
                }
            )

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Fix timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── / ───────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    """Root redirect to docs."""
    return JSONResponse(
        content={
            "service": "Lunascripts API",
            "version": "1.2.0",
            "endpoints": {
                "health": "GET /health",
                "compile": "POST /compile",
                "compile-dir": "POST /compile-dir",
                "decompile": "POST /decompile",
                "validate": "POST /validate",
                "fix": "POST /fix",
            },
            "docs": "/docs",
        }
    )


# ── /health ─────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check endpoint."""
    if not LS_BIN.exists():
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "reason": "lsc binary not found"},
        )
    return {"status": "ok"}
