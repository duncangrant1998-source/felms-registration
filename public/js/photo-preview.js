(function () {
  var input = document.getElementById("headshotInput");
  var wrap = document.getElementById("photoPreview");
  var img = document.getElementById("photoPreviewImg");
  if (!input || !wrap || !img) return;
  input.addEventListener("change", function () {
    var file = input.files && input.files[0];
    if (!file) { wrap.style.display = "none"; return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      img.src = e.target.result;
      wrap.style.display = "block";
    };
    reader.readAsDataURL(file);
  });
})();
