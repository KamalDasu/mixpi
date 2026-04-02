#!/bin/bash
# Test MixPi API and display results

echo "=========================================="
echo "MixPi API Test"
echo "=========================================="
echo ""

BASE_URL="http://localhost:5000"

echo "1. Testing server connectivity..."
if curl -s --connect-timeout 5 "$BASE_URL" > /dev/null; then
    echo "✓ Server is running"
else
    echo "✗ Server is not responding"
    echo "Start the server with: ./dev/run.sh"
    exit 1
fi

echo ""
echo "2. Getting recording status..."
curl -s "$BASE_URL/api/recording/status" | python3 -m json.tool

echo ""
echo "3. Getting configuration..."
curl -s "$BASE_URL/api/config" | python3 -m json.tool

echo ""
echo "4. Listing audio devices..."
curl -s "$BASE_URL/api/devices" | python3 -m json.tool

echo ""
echo "5. Getting sessions..."
curl -s "$BASE_URL/api/sessions" | python3 -m json.tool

echo ""
echo "=========================================="
echo "API Test Complete"
echo "=========================================="
