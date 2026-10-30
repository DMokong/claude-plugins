"""Every Button in the mod names its label, so engines before 2.1.308 can draw it.

Those engines refuse a Button with Text children and no label, and skip the whole render hook.
A label is accepted everywhere, and newer engines still draw the children.

python3 -m unittest discover -s tests   (from plugins/sidekick)
"""
import os
import re
import unittest

SOURCE = os.path.join(os.path.dirname(__file__), "..", "hooks", "register.tsx")


class ButtonLabels(unittest.TestCase):
    def test_every_button_names_its_label(self):
        with open(SOURCE) as f:
            tags = re.findall(r"<Button\b[^\n]*", f.read())
        self.assertTrue(tags)
        self.assertEqual([t for t in tags if not re.search(r"\blabel=", t)], [])


if __name__ == "__main__":
    unittest.main()
