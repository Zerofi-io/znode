#!/usr/bin/env python3
import sys
import struct

def enable_multisig_experimental(keys_file):
    """
    Monero wallet .keys files store attributes after the main data.
    We need to add the enable-multisig-experimental attribute.
    Format: string_length (varint) + string_data + value
    """
    try:
        with open(keys_file, 'rb') as f:
            data = bytearray(f.read())
        
        # Attribute key and value
        attr_key = b'enable-multisig-experimental'
        attr_value = b'1'
        
        # Check if attribute already exists
        if attr_key in data:
            print(f"Attribute already exists in {keys_file}")
            return
        
        # Append the attribute at the end
        # Monero uses length-prefixed strings
        key_len = len(attr_key)
        val_len = len(attr_value)
        
        # Simple append (this is a simplified version)
        data.extend(struct.pack('<B', key_len))
        data.extend(attr_key)
        data.extend(struct.pack('<B', val_len))
        data.extend(attr_value)
        
        # Write back
        with open(keys_file, 'wb') as f:
            f.write(data)
        
        print(f"✓ Added experimental multisig attribute to {keys_file}")
        return True
        
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("Usage: enable-multisig-exp.py <wallet.keys>")
        sys.exit(1)
    
    enable_multisig_experimental(sys.argv[1])
