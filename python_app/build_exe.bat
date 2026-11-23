@echo off
echo ===================================================
echo  Building AI Subtitle Translator Windows EXE...
echo ===================================================
python -m venv .venv
call .venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
pyinstaller --clean AI_Subtitle_Translator.spec
echo.
echo Build finished! Executable location: dist\AI_Subtitle_Translator.exe
pause
