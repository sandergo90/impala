document.querySelectorAll("[data-quiz]").forEach((quiz) => {
  quiz.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = new FormData(quiz).get("answer");
    const feedback = quiz.querySelector(".feedback");
    if (!selected) {
      feedback.textContent = "Choose one operation first.";
      feedback.dataset.state = "wrong";
      return;
    }
    const correct = selected === quiz.dataset.correct;
    feedback.textContent = correct
      ? quiz.dataset.success
      : quiz.dataset.retry;
    feedback.dataset.state = correct ? "correct" : "wrong";
  });
});
