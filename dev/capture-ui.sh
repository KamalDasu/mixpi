#!/bin/bash
# Capture UI state and save to file for inspection

OUTPUT_FILE="dev/ui-state.txt"

echo "=========================================="
echo "MixPi UI State Capture"
echo "=========================================="
echo ""

BASE_URL="http://localhost:5000"

{
    echo "Captured at: $(date)"
    echo ""
    echo "=========================================="
    echo "Server Status"
    echo "=========================================="
    curl -s "$BASE_URL/api/recording/status" | python3 -m json.tool
    
    echo ""
    echo "=========================================="
    echo "Configuration"
    echo "=========================================="
    curl -s "$BASE_URL/api/config" | python3 -m json.tool
    
    echo ""
    echo "=========================================="
    echo "Audio Devices"
    echo "=========================================="
    curl -s "$BASE_URL/api/devices" | python3 -m json.tool
    
    echo ""
    echo "=========================================="
    echo "Sessions"
    echo "=========================================="
    curl -s "$BASE_URL/api/sessions" | python3 -m json.tool
    
} > "$OUTPUT_FILE"

echo "UI state captured to: $OUTPUT_FILE"
echo ""
echo "View with: cat $OUTPUT_FILE"
echo "Or open in Cursor to show me"
